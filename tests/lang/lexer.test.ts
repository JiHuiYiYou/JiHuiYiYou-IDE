import { describe, expect, it } from 'vitest'
import { tokenize } from '../../src/lang/lexer'
import { TokenKind } from '../../src/lang/token'

function kinds(src: string): TokenKind[] {
  return tokenize(src)
    .filter((t) => t.kind !== TokenKind.Eof)
    .map((t) => t.kind)
}

describe('词法分析', () => {
  it('关键字', () => {
    expect(kinds('fn let mut if else while for in match return break continue')).toEqual([
      TokenKind.Fn,
      TokenKind.Let,
      TokenKind.Mut,
      TokenKind.If,
      TokenKind.Else,
      TokenKind.While,
      TokenKind.For,
      TokenKind.In,
      TokenKind.Match,
      TokenKind.Return,
      TokenKind.Break,
      TokenKind.Continue,
    ])
  })

  it('类型关键字与内建', () => {
    expect(kinds('type struct enum import extern as sizeof alignof const defer null volatile')).toEqual([
      TokenKind.Type,
      TokenKind.Struct,
      TokenKind.Enum,
      TokenKind.Import,
      TokenKind.Extern,
      TokenKind.As,
      TokenKind.Sizeof,
      TokenKind.Alignof,
      TokenKind.Const,
      TokenKind.Defer,
      TokenKind.Null,
      TokenKind.Volatile,
    ])
  })

  it('true / false 是布尔字面量，不是独立关键字', () => {
    expect(kinds('true false')).toEqual([TokenKind.Bool, TokenKind.Bool])
  })

  it('十进制 / 十六进制 / 八进制 / 二进制整数', () => {
    expect(kinds('42 0xFF 0o77 0b1010')).toEqual([
      TokenKind.Int,
      TokenKind.Int,
      TokenKind.Int,
      TokenKind.Int,
    ])
  })

  it('旧式八进制 077', () => {
    const [t] = tokenize('077').filter((x) => x.kind !== TokenKind.Eof)
    expect(t.kind).toBe(TokenKind.Int)
  })

  it('浮点数', () => {
    expect(kinds('3.14 1.0f64')).toEqual([TokenKind.Float, TokenKind.Float])
  })

  it('整数类型后缀', () => {
    const tokens = tokenize('42i32 7u8').filter((t) => t.kind !== TokenKind.Eof)
    expect(tokens.map((t) => t.kind)).toEqual([TokenKind.Int, TokenKind.Int])
    expect(tokens[0].text).toBe('42i32')
  })

  it('下划线不是数字的一部分（语言里 1_000_000 是解析错误）', () => {
    // `1` 后面跟 `_000_000` —— 后者被当成标识符
    expect(kinds('1_000')).toEqual([TokenKind.Int, TokenKind.Ident])
  })

  it('字符串与转义', () => {
    const [t] = tokenize('"a\\nb"').filter((x) => x.kind !== TokenKind.Eof)
    expect(t.kind).toBe(TokenKind.String)
    expect(t.text).toBe('"a\\nb"')
  })

  it('字符字面量', () => {
    const [t] = tokenize("'a'").filter((x) => x.kind !== TokenKind.Eof)
    expect(t.kind).toBe(TokenKind.Char)
  })

  it('4 字节 emoji 字符字面量（代理对）', () => {
    const tokens = tokenize("'🎉'").filter((x) => x.kind !== TokenKind.Eof)
    expect(tokens).toHaveLength(1)
    expect(tokens[0].kind).toBe(TokenKind.Char)
    expect(tokens[0].text).toBe("'🎉'")
  })

  it('未闭合的字符字面量报错', () => {
    const tokens = tokenize("'abc").filter((x) => x.kind !== TokenKind.Eof)
    expect(tokens[0].kind).toBe(TokenKind.Error)
  })

  it('行注释与块注释', () => {
    expect(kinds('1 // 注释\n2')).toEqual([TokenKind.Int, TokenKind.Int])
    expect(kinds('1 /* 注释 */ 2')).toEqual([TokenKind.Int, TokenKind.Int])
  })

  it('多行块注释', () => {
    expect(kinds('/* a\nb */ 1')).toEqual([TokenKind.Int])
  })

  it('双字符运算符', () => {
    expect(kinds('== != <= >= && || << >> -> => :: += -= *= /= %=')).toEqual([
      TokenKind.EqEq,
      TokenKind.BangEq,
      TokenKind.LtEq,
      TokenKind.GtEq,
      TokenKind.AmpAmp,
      TokenKind.PipePipe,
      TokenKind.LtLt,
      TokenKind.GtGt,
      TokenKind.Arrow,
      TokenKind.FatArrow,
      TokenKind.ColonColon,
      TokenKind.PlusEq,
      TokenKind.MinusEq,
      TokenKind.StarEq,
      TokenKind.SlashEq,
      TokenKind.PercentEq,
    ])
  })

  it('记录了偏移与行列', () => {
    const tokens = tokenize('fn\n  let').filter((t) => t.kind !== TokenKind.Eof)
    expect(tokens[0].line).toBe(1)
    expect(tokens[0].col).toBe(1)
    expect(tokens[1].line).toBe(2)
    expect(tokens[1].col).toBe(3)
  })
})
