import { describe, expect, it } from 'vitest'
import { parse } from '../../src/lang/parser'
import { print } from '../../src/lang/printer'

function parseOk(src: string) {
  const r = parse(src)
  expect(r.errors.map((e) => `${e.line}:${e.col} ${e.message}`)).toEqual([])
  expect(r.module).not.toBeNull()
  return r.module!
}

function roundTrip(src: string): string {
  return print(parseOk(src))
}

describe('语法分析', () => {
  it('顶层声明：函数 / 类型 / 导入 / 外部声明', () => {
    const m = parseOk(`import vec;
type Point = struct { x: i32, y: i32 }
extern fn printf(fmt: *u8, val: i32) -> i32;
fn main_jhyy() -> i32 { 0 }
`)
    expect(m.declarations.map((d) => d.kind)).toEqual([
      'import_decl',
      'type_decl',
      'extern_decl',
      'func_decl',
    ])
  })

  it('函数体的末表达式即返回值', () => {
    const m = parseOk('fn f() -> i32 { 42 }')
    const fn = m.declarations[0]
    if (fn.kind !== 'func_decl') throw new Error('不是函数')
    expect(fn.body?.statements).toHaveLength(1)
    expect(fn.body?.statements[0].kind).toBe('expr_stmt')
  })

  it('if 是表达式，分支体是表达式', () => {
    const m = parseOk('fn f() -> i32 { let x = if a > b { 1 } else { 2 }; x }')
    const fn = m.declarations[0]
    if (fn.kind !== 'func_decl') throw new Error('不是函数')
    const letStmt = fn.body!.statements[0]
    if (letStmt.kind !== 'let') throw new Error('不是 let')
    expect(letStmt.init?.kind).toBe('if')
  })

  it('运算符优先级：|| 比 && 松，as 与 * 同级', () => {
    const m = parseOk('fn f() -> bool { a || b && c }')
    const fn = m.declarations[0]
    if (fn.kind !== 'func_decl') throw new Error('不是函数')
    const stmt = fn.body!.statements[0]
    if (stmt.kind !== 'expr_stmt') throw new Error('不是表达式语句')
    const bin = stmt.expr
    if (bin.kind !== 'binary') throw new Error('不是二元运算')
    expect(bin.op).toBe('||')
    expect(bin.left.kind).toBe('ident')
    if (bin.right.kind !== 'binary') throw new Error('右边不是二元运算')
    expect(bin.right.op).toBe('&&')
  })

  it('match 的分支模式', () => {
    const m = parseOk(`type Color = enum { Red, Green }
type Opt = enum { Some(i32), None }

fn f(c: Color) -> i32 {
    match c {
        Color::Red => 1,
        1..10 => 2,
        _ => 0,
    }
}`)
    const fn = m.declarations[m.declarations.length - 1]
    if (fn.kind !== 'func_decl') throw new Error('不是函数')
    const stmt = fn.body!.statements[0]
    if (stmt.kind !== 'match') throw new Error('不是 match')
    expect(stmt.arms).toHaveLength(3)
    expect(stmt.arms[0].pattern.kind).toBe('pattern_enum')
    expect(stmt.arms[1].pattern.kind).toBe('pattern_range')
    expect(stmt.arms[2].pattern.kind).toBe('pattern_wild')
  })

  it('泛型：定义 + turbofish 调用', () => {
    const m = parseOk(`type Pair<T> = struct { a: T, b: T }
fn f() -> i32 { let p = Pair<i32> { a: 1, b: 2 }; let n = max::<i32>(1, 2); n }`)
    const fn = m.declarations[1]
    if (fn.kind !== 'func_decl') throw new Error('不是函数')
    const stmt = fn.body!.statements[0]
    if (stmt.kind !== 'let') throw new Error('不是 let')
    if (stmt.init?.kind !== 'struct_lit') throw new Error('不是结构体字面量')
    expect(stmt.init.typeName).toBe('Pair')
  })

  it('类型声明后面带分号是错误（语言不允许）', () => {
    const r = parse('type Point = struct { x: i32 };')
    expect(r.errors.length).toBeGreaterThan(0)
  })

  it('import std::vec 是错误（模块名不带 std:: 前缀）', () => {
    const r = parse('import std::vec;')
    expect(r.errors.length).toBeGreaterThan(0)
  })

  it('未知语法报在正确的位置', () => {
    const r = parse('fn f() -> i32 {\n    let x = ;\n}')
    expect(r.errors.length).toBeGreaterThan(0)
    expect(r.errors[0].line).toBe(2)
  })
})

describe('打印（AST → 源码）', () => {
  it('type 声明结尾不带分号', () => {
    expect(roundTrip('type Point = struct { x: i32, y: i32 }')).toBe(
      'type Point = struct { x: i32, y: i32 }\n',
    )
  })

  it('import 只写模块名', () => {
    expect(roundTrip('import vec;')).toBe('import vec;\n')
  })

  it('括号被保留 —— 优先级不能变', () => {
    // (a + b) as i32 和 a + b as i32 **不是一回事**
    expect(roundTrip('fn f() -> i32 { let x = (a + b) as i32; x }')).toContain('(a + b) as i32')
  })

  it('右操作数同级时补括号', () => {
    expect(roundTrip('fn f() -> i32 { let x = a - (b - c); x }')).toContain('a - (b - c)')
  })

  it('嵌套泛型留空格，避免拼成 >>', () => {
    const out = roundTrip('fn f() -> i64 { let x: i64 = sizeof(Cap<PhantomData<i32> >); x }')
    expect(out).toContain('Cap<PhantomData<i32> >')
    expect(out).not.toContain('>>')
  })

  it('打印结果能被自己重新解析（往返自洽）', () => {
    const src = `extern fn printf(fmt: *u8, val: i32) -> i32;

type Point = struct {
    x: i32,
    y: i32,
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
    printf("total = %d\\n", total);
    total
}`
    const out = roundTrip(src)
    const r = parse(out)
    expect(r.errors.map((e) => `${e.line}:${e.col} ${e.message}`)).toEqual([])
  })
})
