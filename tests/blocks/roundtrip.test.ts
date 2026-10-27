import { describe, expect, it } from 'vitest'
import { compileModule } from '../../src/lang/blocks/compile'
import { decompileModule } from '../../src/lang/blocks/decompile'
import { parse } from '../../src/lang/parser'
import { print } from '../../src/lang/printer'

/**
 * 块往返测试 —— 纯 TS，不碰 Blockly / 浏览器。
 *
 * 数据流：源码 → AST → 块树 → AST → 源码。
 * 块视图和文本视图共用这同一套 AST + 打印器，所以这里过了，
 * 两边就不可能对同一份代码产生不同的输出。
 */

const SAMPLE = `extern fn printf(fmt: *u8, val: i32) -> i32;

type Point = struct {
    x: i32,
    y: i32,
}

type Color = enum {
    Red,
    Green,
}

fn add(a: i32, b: i32) -> i32 {
    a + b
}

fn main_jhyy() -> i32 {
    let mut total = 0;
    let mut i = 0;
    while i < 10 {
        total = total + add(i, 1);
        i = i + 1;
    }
    let p = Point { x: 1, y: 2 };
    let c = Color::Red;
    let m = match c {
        Color::Red => 1,
        _ => 0,
    };
    match c {
        Color::Red => 2,
        _ => 3,
    }
    printf("total = %d\\n", total);
    total
}
`

function roundTrip(src: string): { tree: unknown; out: string } {
  const parsed = parse(src)
  expect(parsed.errors).toEqual([])
  expect(parsed.module).not.toBeNull()
  const tree = decompileModule(parsed.module!, src)
  const out = print(compileModule(tree))
  return { tree, out }
}

describe('块往返', () => {
  it('源码 → 块树 → 源码，语义保持', () => {
    const { out } = roundTrip(SAMPLE)
    // 打印结果必须还能被解析（往返自洽）
    const reparsed = parse(out)
    expect(reparsed.errors.map((e) => `${e.line}:${e.col} ${e.message}`)).toEqual([])
  })

  it('extern 声明会变成不透明块（原文保留）', () => {
    const { tree } = roundTrip(SAMPLE)
    const trees = tree as { type: string; fields?: Record<string, string> }[]
    const opaque = trees.find((t) => t.type === 'jhyy_opaque')
    expect(opaque, '应该有一个不透明块装 extern 声明').toBeTruthy()
    expect(opaque!.fields?.CODE).toContain('extern fn printf')
  })

  it('不透明块的内容能原样还原', () => {
    const { out } = roundTrip(SAMPLE)
    expect(out).toContain('extern fn printf(fmt: *u8, val: i32) -> i32;')
  })

  it('函数、变量、循环、调用都在', () => {
    const { out } = roundTrip(SAMPLE)
    expect(out).toContain('fn add(a: i32, b: i32) -> i32')
    expect(out).toContain('let mut total = 0;')
    expect(out).toContain('while i < 10')
    expect(out).toContain('printf("total = %d\\n", total);')
  })

  it('结构体定义与字面量都在', () => {
    const { out } = roundTrip(SAMPLE)
    expect(out).toContain('type Point = struct {')
    expect(out).toContain('Point { x: 1, y: 2 }')
  })

  it('match 的分支都在', () => {
    const { out } = roundTrip(SAMPLE)
    expect(out).toContain('match c {')
    expect(out).toContain('Color::Red => 1')
  })

  it('块树里语句形态和值形态是分开的', () => {
    const { tree } = roundTrip(SAMPLE)
    const text = JSON.stringify(tree)
    // 调用在语句位置 → 语句形态；赋值在值位置 → 值形态
    expect(text).toContain('jhyy_call_stmt')
  })
})
