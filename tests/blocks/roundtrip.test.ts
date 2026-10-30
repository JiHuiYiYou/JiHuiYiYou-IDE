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

  it('extern 声明变成「C 函数声明」块（不用逃生舱）', () => {
    const { tree } = roundTrip(SAMPLE)
    const trees = tree as { type: string; fields?: Record<string, string> }[]
    const extern = trees.find((t) => t.type === 'jhyy_extern')
    expect(extern, '应该有一个 C 函数声明块').toBeTruthy()
    expect(extern!.fields?.NAME).toBe('printf')
    expect(extern!.fields?.PARAMS).toBe('fmt: *u8, val: i32')
    expect(extern!.fields?.RET).toBe('i32')
  })

  it('不透明块的内容能原样还原', () => {
    const { out } = roundTrip(SAMPLE)
    expect(out).toContain('extern fn printf(fmt: *u8, val: i32) -> i32;')
  })

  it('C 函数声明块往返无损', () => {
    const { out } = roundTrip(SAMPLE)
    expect(out).toContain('extern fn printf(fmt: *u8, val: i32) -> i32;')
  })

  it('没有返回值的 C 函数（free）也能往返', () => {
    const src = `extern fn free(p: *u8);

fn main_jhyy() -> i32 {
    0
}
`
    const { out } = roundTrip(src)
    expect(out).toContain('extern fn free(p: *u8);')
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
    // 值位置的调用 → 值形态（`add(i, 1)`）
    expect(text).toContain('jhyy_call')
    // 语句位置的 printf → **专用的打印块**（不用「调用 + 实参 + 实参」三层）
    expect(text).toContain('jhyy_print')
    expect(text).not.toContain('jhyy_call_stmt')
  })

  it('printf 变成打印块（格式串 + 一个值孔）', () => {
    const { tree } = roundTrip(SAMPLE)
    const trees = tree as { type: string; fields?: Record<string, string> }[]
    const fn = trees.find((t) => t.type === 'jhyy_func' && t.fields?.NAME === 'main_jhyy')
    const body = (fn as unknown as { statements: { BODY: { type: string; fields?: Record<string, string> }[] } })
      .statements.BODY
    const print = body.find((b) => b.type === 'jhyy_print')
    expect(print, 'printf 应该变成打印块').toBeTruthy()
    // 格式串的内容（**不含引号**，转义保持原样）
    expect(print!.fields?.FMT).toBe('total = %d\\n')
  })
})

/**
 * 「语句形态」和「值形态」必须是**两个不同的块**。
 *
 * ⚠️ 这不是审美问题 —— Blockly 有硬约束：
 * 灌 XML 时给子块挑连接口的顺序是**先 output、再 previous**
 * （它分不清 `<statement>` 和 `<value>`）。所以一个「既有输出连接又有前后
 * 连接」的块，放进**语句容器**时会被拿输出连接去接语句口 ⇒
 * **"Attempt to connect incompatible types."** ⇒ 块视图直接崩。
 *
 * 反过来，语句形态的块放进**值输入**也一样崩。
 */
describe('语句形态 / 值形态', () => {
  const EXPRS = `fn main_jhyy() -> i32 {
    let mut a = 0;
    let x = if a > 0 { 1 } else { 0 };
    let y = (a = 5);
    if a > 1 { a = 2; } else { a = 3; }
    a
}
`

  function treeOf(src: string) {
    const parsed = parse(src)
    expect(parsed.errors).toEqual([])
    return decompileModule(parsed.module!, src)
  }

  it('表达式位置的 if 用值形态（jhyy_if_val）', () => {
    const trees = treeOf(EXPRS)
    const text = JSON.stringify(trees)
    expect(text).toContain('jhyy_if_val')
  })

  it('表达式位置的赋值用值形态（jhyy_set_val）', () => {
    const trees = treeOf(EXPRS)
    const text = JSON.stringify(trees)
    expect(text).toContain('jhyy_set_val')
  })

  it('语句位置的 if 用语句形态（jhyy_if）', () => {
    const trees = treeOf(EXPRS)
    const main = trees.find((t) => t.type === 'jhyy_func')
    const body = main?.statements?.BODY ?? []
    const ifStmt = body.find((t) => t.type === 'jhyy_if')
    expect(ifStmt, '函数体里应该有一个语句形态的 if').toBeTruthy()
    expect(ifStmt!.type).toBe('jhyy_if')
  })

  it('语句形态的 if 不带输出连接（反编译出来就是语句形态）', () => {
    const trees = treeOf(EXPRS)
    // 语句形态的 if 出现在 THEN / ELSE **语句容器**里 —— 那是它的合法位置
    const main = trees.find((t) => t.type === 'jhyy_func')
    const body = main?.statements?.BODY ?? []
    const ifStmt = body.find((t) => t.type === 'jhyy_if')
    const thenList = ifStmt?.statements?.THEN ?? []
    // THEN 里的块都是语句形态（赋值 → jhyy_set）
    expect(thenList.every((t) => t.type !== 'jhyy_set_val')).toBe(true)
  })

  it('往返之后源码还是能解析', () => {
    const parsed = parse(EXPRS)
    const out = print(compileModule(decompileModule(parsed.module!, EXPRS)))
    const reparsed = parse(out)
    expect(reparsed.errors.map((e) => `${e.line}:${e.col} ${e.message}`)).toEqual([])
  })
})

/**
 * `if` / `match` 在**表达式位置**的往返。
 *
 * ⚠️ 值形态的 `if`（`jhyy_if_val`）的 else 分支装在**语句容器**里 ——
 * 而语句容器放不下值块 ⇒ else-if 链要用「表达式语句」块包一层。
 * 编译回来的时候**必须分清**「exprStmt 包着 if」（else-if 链）和
 * 「exprStmt 包着一个值」（普通的 `else { 3 }`）——
 * 分不清的话**整个 else 分支会被悄悄丢掉**。
 */
describe('表达式位置的 if / match', () => {
  function roundTrip(src: string): string {
    const parsed = parse(src)
    expect(parsed.errors.map((e) => `${e.line}:${e.col} ${e.message}`)).toEqual([])
    return print(compileModule(decompileModule(parsed.module!, src)))
  }

  it('值形态的 if 带 else 分支 —— 分支不能丢', () => {
    const out = roundTrip(`fn main_jhyy() -> i32 {
    let a = 1;
    let x = if a > 0 { 1 } else { 3 };
    x
}`)
    expect(out).toContain('else')
    expect(out).toContain('3')
  })

  it('值形态的 if 带 else-if 链 —— 链和最后的 else 都不能丢', () => {
    const out = roundTrip(`fn main_jhyy() -> i32 {
    let a = 1;
    let x = if a > 0 { 1 } else if a < 0 { 2 } else { 3 };
    x
}`)
    expect(out).toContain('else if')
    expect(out).toContain('2')
    expect(out).toContain('3')
  })

  it('语句形态的 if 带 else-if 链', () => {
    const out = roundTrip(`fn main_jhyy() -> i32 {
    let a = 1;
    if a > 0 { a = 1; } else if a < 0 { a = 2; } else { a = 3; }
    a
}`)
    expect(out).toContain('else if')
    expect(out).toContain('a = 3;')
  })

  it('值形态的 match', () => {
    const out = roundTrip(`fn main_jhyy() -> i32 {
    let a = 1;
    let m = match a { 1 => 10, _ => 20 };
    m
}`)
    expect(out).toContain('match a')
    expect(out).toContain('10')
    expect(out).toContain('20')
  })
})

/**
 * 「读入」块 —— `scanf("%d", &x)`。
 *
 * ⚠️ 取地址由块**自己加** —— 「取地址」在块子集里没有对应的块
 * （以前新手只能靠「原始代码」逃生舱）。
 */
describe('读入块', () => {
  const SRC = `extern fn scanf(fmt: *u8, val: *i32) -> i32;

fn main_jhyy() -> i32 {
    let mut x: i32 = 0;
    scanf("%d", &x);
    x
}
`

  it('scanf("%d", &x) 变成读入块', () => {
    const parsed = parse(SRC)
    expect(parsed.errors).toEqual([])
    const trees = decompileModule(parsed.module!, SRC)
    expect(JSON.stringify(trees)).toContain('jhyy_input')
  })

  it('往返无损（取地址回来了）', () => {
    const parsed = parse(SRC)
    const out = print(compileModule(decompileModule(parsed.module!, SRC)))
    expect(out).toContain('scanf("%d", &x)')
    expect(parse(out).errors).toEqual([])
  })

  it('别的 scanf 用法不会被误认成读入块', () => {
    const src = `extern fn scanf(fmt: *u8, val: *i32) -> i32;

fn main_jhyy() -> i32 {
    let mut x: i32 = 0;
    scanf("%d", &x);
    scanf("%s", &x);
    x
}
`
    const parsed = parse(src)
    const trees = decompileModule(parsed.module!, src)
    // 第一个是读入块，第二个还是普通的调用块
    const kinds = JSON.stringify(trees).match(/jhyy_input/g)?.length ?? 0
    expect(kinds).toBe(1)
  })
})
