// @vitest-environment jsdom
import { StringStream, type StreamParser } from '@codemirror/language'
import { describe, expect, it } from 'vitest'
import { jhyyLanguage } from '../../src/renderer/editor/jhyyLanguage'

/**
 * **词法**（`jhyyLanguage` 的 token 流）。
 *
 * ⚠️⚠️ **为什么手写了扫描器** ——
 *   CodeMirror 的 `StringStream.match(正则)` 是这么实现的：
 *   `this.string.slice(this.pos).match(pattern)` ⇒
 *   **每匹配一次就把「这一行从当前位置往后」切一份出来** ⇒
 *   ⇒ 一行里有 N 个 token 就要切 N 次 ⇒ **O(行长²)** ✗✗
 *   ⇒ 而字符串字面量那一条更狠：正则**每个字符都要跑一次** ⇒
 *   ⇒ 一个 5000 字符的字符串 ⇒ 5000 次切片 ⇒ 几十 MB 的垃圾 ✗
 *
 * ⇒ 现在**自己扫**（只比较字符，不切片）⇒ **O(行长)** ✓
 *
 * ⚠️ **这个测试钉的是「重写之后词法还对不对」** ——
 *   手写扫描器最容易错的地方：进制数字、转义、字符字面量、标识符的字符集 ✓
 */

interface Tok {
  token: string
  value: string
}

/** 把一段源码过一遍 token 流。 */
function tokenize(text: string): Tok[] {
  // ⚠️ `LanguageSupport` 上是 `.language`；`Language` 上是 `.streamParser` ✓
  const parser = (
    jhyyLanguage.language as unknown as {
      streamParser: StreamParser<unknown>
    }
  ).streamParser
  // ⚠️ `startState(indentUnit)` —— 参数是缩进宽度，不是 parser ✓
  const state = parser.startState ? parser.startState(2) : null
  const out: Tok[] = []
  // ⚠️ `StringStream(整行, tab 宽度, 缩进宽度)` ✓
  const stream = new StringStream(text, 4, 2)
  for (;;) {
    stream.start = stream.pos
    const token = parser.token(stream, state as never)
    // ⚠️ **返回 `null` 但往前走了 = 「这是空白，不是 token」** ——
    //   CodeMirror 自己的 `readToken` 就是这么判的（`@codemirror/language`）⇒
    //   ⇒ 不能因为 `null` 就停 —— 得看**流有没有往前走** ✓
    if (stream.pos <= stream.start) break
    if (token !== null) out.push({ token, value: stream.current() })
  }
  return out
}

/** 找出某个值的 token 名字。 */
function tokenOf(text: string, value: string): string | undefined {
  return tokenize(text).find((t) => t.value === value)?.token
}

describe('词法 —— 数字', () => {
  it('十进制 / 浮点', () => {
    expect(tokenOf('123', '123')).toBe('number')
    expect(tokenOf('1.5', '1.5')).toBe('number')
    expect(tokenOf('0', '0')).toBe('number')
  })

  it('十六进制 / 八进制 / 二进制', () => {
    expect(tokenOf('0xFF', '0xFF')).toBe('number')
    expect(tokenOf('0o77', '0o77')).toBe('number')
    expect(tokenOf('0b1010', '0b1010')).toBe('number')
  })

  it('`0x` 后面没有数字 ⇒ 退回十进制（`0` 一个 token，`x` 另一个）', () => {
    const toks = tokenize('0x')
    expect(toks[0]).toEqual({ token: 'number', value: '0' })
    expect(toks[1]?.value).toBe('x')
  })

  it('`123.` 后面没有数字 ⇒ 只吃 `123`（`.` 归标点）', () => {
    const toks = tokenize('123.')
    expect(toks[0]).toEqual({ token: 'number', value: '123' })
    expect(toks[1]?.token).toBe('punctuation')
  })

  it('`1_000` 不是合法数字（语言里下划线分隔是语法错误）⇒ `_` 归标识符', () => {
    const toks = tokenize('1_000')
    expect(toks[0]).toEqual({ token: 'number', value: '1' })
    expect(toks[1]?.token).toBe('variableName')
  })
})

describe('词法 —— 字符串与转义', () => {
  it('普通字符串（引号、内容、收尾引号各一个 token，颜色一样）', () => {
    const toks = tokenize('"hello"')
    expect(toks.map((t) => t.token)).toEqual(['string', 'string', 'string'])
    expect(toks.map((t) => t.value).join('')).toBe('"hello"')
  })

  it('转义序列单独一个 token', () => {
    const toks = tokenize('"a\\nb"')
    expect(toks.some((t) => t.token === 'escape' && t.value === '\\n')).toBe(true)
  })

  it('`\\u{1F600}` 整段算一个转义', () => {
    const toks = tokenize('"\\u{1F600}"')
    expect(toks.some((t) => t.token === 'escape' && t.value === '\\u{1F600}')).toBe(true)
  })

  it('字符字面量', () => {
    const toks = tokenize("'a'")
    expect(toks.map((t) => t.token)).toEqual(['string', 'string', 'string'])
    expect(toks.map((t) => t.value).join('')).toBe("'a'")
  })
})

describe('词法 —— 标识符与关键字', () => {
  it('关键字 / 类型名 / 布尔 / null', () => {
    expect(tokenOf('fn', 'fn')).toBe('keyword')
    expect(tokenOf('let', 'let')).toBe('keyword')
    expect(tokenOf('i32', 'i32')).toBe('typeName')
    expect(tokenOf('true', 'true')).toBe('bool')
    expect(tokenOf('false', 'false')).toBe('bool')
    expect(tokenOf('null', 'null')).toBe('null')
  })

  it('大写开头的名字按类型名处理（语言约定）', () => {
    expect(tokenOf('Foo', 'Foo')).toBe('typeName')
  })

  it('普通名字是变量名', () => {
    expect(tokenOf('value', 'value')).toBe('variableName')
  })

  it('标识符里能有 `_` 和数字', () => {
    expect(tokenOf('_x1', '_x1')).toBe('variableName')
  })
})

describe('词法 —— 注释与标点', () => {
  it('行注释 / 块注释', () => {
    expect(tokenOf('// hi', '// hi')).toBe('comment')
    expect(tokenize('/* hi */')[0]?.token).toBe('comment')
  })

  it('括号 / 标点 / 运算符 / 属性', () => {
    expect(tokenOf('(', '(')).toBe('bracket')
    expect(tokenOf(';', ';')).toBe('punctuation')
    expect(tokenOf('->', '->')).toBe('operator')
    // ⚠️ **属性只吃 `#` + 一个标识符字符**（跟老实现 `/^#[A-Za-z_]/` 一样）✓
    expect(tokenize('#derive')[0]).toEqual({ token: 'meta', value: '#d' })
  })

  /*
    ⚠️⚠️ **`#[inline]` 以前是「红色的无效」** ——
      老实现是 `/^#[A-Za-z_]/` ⇒ `#` 后面得跟一个标识符字符 ⇒
      而 `#[inline]` 的 `#` 后面是 `[` ⇒ 匹配不上 ⇒ 落到兜底 ⇒ `invalid`
      ⇒ 编辑器里那个 `#` 是**红的** ⇒ 看着像语法错误，其实完全合法 ✗
      ⇒ 现在：`#[…]` 整段算一个 `meta` token ✓
  */
  it('属性（`#[inline]` / `#[no_std]`）整段算 meta，不是 invalid', () => {
    expect(tokenize('#[inline]')).toEqual([{ token: 'meta', value: '#[inline]' }])
    expect(tokenize('#[no_std]')).toEqual([{ token: 'meta', value: '#[no_std]' }])
    // ⚠️ **没有收尾的 `]` ⇒ 别把整行都吃掉** ⇒ 退回老行为（`#` 是 invalid）✓
    expect(tokenize('#[inline')[0]).toEqual({ token: 'invalid', value: '#' })
  })

  it('`<<` 不能被 `<` 抢先匹配（长的排前面）', () => {
    expect(tokenOf('<<', '<<')).toBe('operator')
  })
})

describe('词法 —— 超长行不会卡', () => {
  it('一行 20 万字符照样扫完（回归网：以前是 O(行长²)）', () => {
    const line = 'let x = 1234; // ' + 'a'.repeat(200_000)
    const t0 = performance.now()
    const toks = tokenize(line)
    const ms = performance.now() - t0
    // ⚠️ **只断言「扫完了」+「token 数合理」** ——
    //   绝对耗时在 CI 上不稳定 ⇒ 只能当参考 ⇒ 真正的闸是「不超时」✓
    expect(toks.length).toBeGreaterThan(3)
    expect(ms).toBeLessThan(10_000)
  })
})
