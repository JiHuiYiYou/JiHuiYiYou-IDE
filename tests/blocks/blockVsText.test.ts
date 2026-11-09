import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileModule } from '../../src/lang/blocks/compile'
import { decompileModule } from '../../src/lang/blocks/decompile'
import { parse } from '../../src/lang/parser'
import { print } from '../../src/lang/printer'
import { examplesDir, ideRoot } from '../helpers/repo'

/**
 * **块视图和文本视图必须对同一份代码产生同样的输出。**
 *
 * ⚠️ 这是 CLAUDE.md 铁律 #1 的直接编码：
 *
 *   > 源码 ──parse──▶ AST ──decompile──▶ 块树 ──▶ Blockly 工作区
 *   >                  ▲                                │
 *   >                  └──────────── 块树 ◀─────────────┘
 *   >   块树 ──compile──▶ AST ──print──▶ 源码
 *
 *   **不要在两边各写一套代码生成逻辑** —— 那样两边迟早对同一份代码产生不同输出。
 *
 * ## 为什么这条测试以前没有
 *
 * 现有的测试各管一段：
 * - `tests/conformance/examples.test.ts`：**源码 → IDE 解析 → IDE 打印 → 真实编译器**
 *   ⇒ 中间**没有块这一步**
 * - `tests/renderer/blockWorkspace.test.ts`：**反编译的树 ↔ Blockly 工作区读回来的树**
 *   ⇒ 中间**没有 compile/print**
 * - `tests/blocks/roundtrip.test.ts`：块往返 ⇒ 只断言「输出还能被解析」
 *
 * ⇒ 「块树 → AST → 源码」这一段**没人管** ⇒ 凡是这一段有损的 bug，
 *   测试网一个都漏（实测漏过 5 个：切片循环被改成 `..0`、短枚举名丢绑定、
 *   字面量的 `KIND` 下拉没用、`let x;` 不是合法 JHYY、`defer` 语句凭空消失）。
 *
 * ## 这条测试抓什么
 *
 *   print(parse(src))  ===  print(compileModule(decompileModule(parse(src))))
 *              ↑ 文本视图              ↑ 块视图
 *
 * 两条路**必须一字不差**。块视图改了任何东西，文本视图就得跟着改 ——
 * 而块视图**会回写用户的源文件**（`App.tsx` 的 `onBlockChange`）⇒
 * 不一致 = **用户的代码被悄悄改掉**。
 */

function walk(dir: string, out: string[] = []): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith('.jhyy')) out.push(full)
  }
  return out
}

/** 语料：本仓库的 samples + 语言仓库的 examples（后者不在就跳过）。 */
function corpus(): string[] {
  const roots = [join(ideRoot, 'samples')]
  const examples = examplesDir()
  if (examples) roots.push(examples)
  return roots.flatMap((r) => walk(r)).sort()
}

describe('块视图 ≡ 文本视图', () => {
  it('语料里每个例子：两条路打印出来的源码一字不差', () => {
    const files = corpus()
    expect(files.length).toBeGreaterThan(0)

    const mismatched: string[] = []
    let checked = 0

    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      const parsed = parse(src)
      // 源码本身有语法错误 ⇒ 块视图根本建不出来（那是另一条路的问题）
      if (!parsed.module || parsed.errors.length > 0) continue

      const textPath = print(parsed.module)
      const blockPath = print(compileModule(decompileModule(parsed.module, src)))
      if (textPath !== blockPath) {
        mismatched.push(file)
        if (mismatched.length <= 3) {
          const at = firstDifference(textPath, blockPath)
          console.log(
            `\n对不上: ${file}\n` +
              `  文本视图: ...${textPath.slice(Math.max(0, at - 60), at + 60)}\n` +
              `  块视图:   ...${blockPath.slice(Math.max(0, at - 60), at + 60)}`,
          )
        }
        continue
      }
      checked++
    }

    if (mismatched.length) {
      console.log('对不上的文件:\n' + mismatched.join('\n'))
    }
    expect(mismatched).toEqual([])
    expect(checked).toBeGreaterThan(0)
  }, 600_000)

  it('往返之后源码还能被解析（自洽）', () => {
    const broken: string[] = []
    for (const file of corpus()) {
      const src = readFileSync(file, 'utf8')
      const parsed = parse(src)
      if (!parsed.module || parsed.errors.length > 0) continue
      const out = print(compileModule(decompileModule(parsed.module, src)))
      const reparsed = parse(out)
      if (reparsed.errors.length > 0) {
        broken.push(`${file}: ${reparsed.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join('; ')}`)
      }
    }
    if (broken.length) console.log('解析不过的:\n' + broken.join('\n'))
    expect(broken).toEqual([])
  }, 600_000)
})

/** 两段文本第一个不同的位置。 */
function firstDifference(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return n
}

/**
 * 下面几条是**具体 bug** 的回归钉子 ——
 * 它们各自都曾让用户的源码被悄悄改掉，而且**编译器不报错**。
 */
describe('曾经把用户源码改坏的几个坑', () => {
  /** 走一遍「文本 → 块 → 文本」，返回块视图打印出来的源码。 */
  function viaBlocks(src: string): string {
    const parsed = parse(src)
    expect(parsed.errors, '这段源码自己得先能解析').toEqual([])
    expect(parsed.module).not.toBeNull()
    return print(compileModule(decompileModule(parsed.module!, src)))
  }

  it('`for x in slice` 不能被改成 `for x in slice..0`', () => {
    // 区间是**半开**的 ⇒ `s..0` 是空区间 ⇒ 循环体一次都不跑，而编译器不报错
    const out = viaBlocks(`fn main_jhyy() -> i32 {
    let s = [1, 2, 3];
    let mut t = 0;
    for x in s { t = t + x; }
    t
}
`)
    expect(out).toContain('for x in s {')
    expect(out).not.toContain('s..0')
  })

  it('`match` 用短枚举名时，模式里的绑定不能丢', () => {
    // 以前 `Some(v) => v` 变成 `Some => v` ⇒ body 引用了一个未定义的变量
    const out = viaBlocks(`type Opt = enum { Some(i32), None }

fn f(x: Opt) -> i32 {
    match x { Some(v) => v, None => 0 }
}
`)
    expect(out).toContain('Some(v)')
    expect(out).not.toMatch(/Some\s*=>/)
  })

  it('限定写法 `Opt::Some(v)` 也不能被改坏', () => {
    const out = viaBlocks(`type Opt = enum { Some(i32), None }

fn f(x: Opt) -> i32 {
    match x { Opt::Some(v) => v, Opt::None => 0 }
}
`)
    expect(out).toContain('Opt::Some(v)')
  })

  it('`defer` 语句不能在往返时凭空消失', () => {
    // 以前不透明块的内容是「defer cleanup();\n    let」（节点 end 越界），
    // 而重解析只认 `expr_stmt` / `let` ⇒ defer 被丢掉 ⇒ 变成 `let ;`
    const out = viaBlocks(`fn cleanup() { let x = 1; }

fn main_jhyy() -> i32 {
    defer cleanup();
    let y = 2;
    y
}
`)
    expect(out).toContain('defer cleanup();')
    expect(out).not.toContain('let ;')
  })

  it('字面量块的 `KIND` 下拉必须真的起作用', () => {
    // `KIND='string'` + 内容 `hi` ⇒ 必须生成 `"hi"`，不是 `hi`（一个标识符！）
    const out = print(
      compileModule([
        {
          type: 'jhyy_let',
          fields: { NAME: 'v', MUT: 'FALSE' },
          inputs: { VALUE: { type: 'jhyy_value', fields: { KIND: 'string', VALUE: 'hi' } } },
        },
      ]),
    )
    expect(out).toContain('"hi"')

    const charOut = print(
      compileModule([
        {
          type: 'jhyy_let',
          fields: { NAME: 'v', MUT: 'FALSE' },
          inputs: { VALUE: { type: 'jhyy_value', fields: { KIND: 'char', VALUE: 'x' } } },
        },
      ]),
    )
    expect(charOut).toContain("'x'")
  })

  it('空的 `let` 值不能生成 `let x;`（那不是合法 JHYY）', () => {
    const out = print(
      compileModule([
        { type: 'jhyy_let', fields: { NAME: 'x', MUT: 'FALSE' }, inputs: {} },
      ]),
    )
    expect(out).not.toContain('let x;')
    expect(out).toContain('let x = 0;')
    // 而且它得能被解析（IDE 自己的解析器也不接受 `let x;`）
    expect(parse(out).errors).toEqual([])
  })

  it('「原始代码」块里不能混进下一个声明的字', () => {
    // 以前节点的 end 越界 ⇒ 不透明块里多了一个 `fn`
    const src = `const LIMIT = 10;

fn cleanup() { let x = 1; }
`
    const parsed = parse(src)
    expect(parsed.errors).toEqual([])
    const trees = decompileModule(parsed.module!, src)
    const opaqueBlock = trees.find((t) => t.type === 'jhyy_opaque')
    expect(opaqueBlock).toBeTruthy()
    const code = opaqueBlock!.fields?.CODE ?? ''
    expect(code).not.toContain('fn')
    expect(code).toContain('const LIMIT = 10;')
  })
})
