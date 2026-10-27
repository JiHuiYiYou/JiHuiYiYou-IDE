/**
 * Token 类型 —— 编号与编译器 `compiler/src0/lexer.jhyy` 的 TOKEN_* 常量**一一对应**。
 * 保持编号一致的好处：将来编译器若支持 `jhyy ast --json`，两边可以按 kind 直接对齐。
 */
export enum TokenKind {
  // literals (0-4)
  Int = 0,
  Float = 1,
  String = 2,
  Char = 3,
  Bool = 4,
  // identifier (5)
  Ident = 5,
  // keywords (6-26)
  Fn = 6,
  Let = 7,
  Mut = 8,
  If = 9,
  Else = 10,
  While = 11,
  For = 12,
  In = 13,
  Match = 14,
  Return = 15,
  Break = 16,
  Continue = 17,
  Type = 18,
  Struct = 19,
  Enum = 20,
  Import = 21,
  Extern = 22,
  As = 23,
  Sizeof = 24,
  Alignof = 25,
  Const = 26,
  // operators (27-52)
  Plus = 27,
  Minus = 28,
  Star = 29,
  Slash = 30,
  Percent = 31,
  Eq = 32,
  EqEq = 33,
  BangEq = 34,
  Lt = 35,
  Gt = 36,
  LtEq = 37,
  GtEq = 38,
  Bang = 39,
  Amp = 40,
  AmpAmp = 41,
  Pipe = 42,
  PipePipe = 43,
  Tilde = 44,
  Caret = 45,
  LtLt = 46,
  GtGt = 47,
  PlusEq = 48,
  MinusEq = 49,
  StarEq = 50,
  SlashEq = 51,
  PercentEq = 52,
  // brackets (53-58)
  LParen = 53,
  RParen = 54,
  LBrace = 55,
  RBrace = 56,
  LBracket = 57,
  RBracket = 58,
  // misc (59-66)
  Dot = 59,
  DotDot = 60,
  Comma = 61,
  Semicolon = 62,
  Colon = 63,
  ColonColon = 64,
  Arrow = 65,
  FatArrow = 66,
  // control (67-72)
  Eof = 67,
  Error = 68,
  Null = 69,
  Defer = 70,
  Hash = 71,
  Volatile = 72,
}

/** 一个 token。 */
export interface Token {
  kind: TokenKind
  /** 在源字符串中的起始下标（UTF-16 code unit，与 CodeMirror 的位置一致） */
  start: number
  /** 长度（UTF-16 code unit） */
  length: number
  /** 1-based 行号 */
  line: number
  /** 1-based 列号 */
  col: number
  /** 原始文本 */
  text: string
  /** kind === Error 时的错误信息 */
  errorMessage?: string
}

/** 关键字表 —— 对应编译器 `lookup_keyword`。25 个关键字 + true/false。 */
const KEYWORDS: Record<string, TokenKind> = {
  fn: TokenKind.Fn,
  if: TokenKind.If,
  in: TokenKind.In,
  as: TokenKind.As,
  let: TokenKind.Let,
  mut: TokenKind.Mut,
  for: TokenKind.For,
  else: TokenKind.Else,
  true: TokenKind.Bool,
  false: TokenKind.Bool,
  type: TokenKind.Type,
  enum: TokenKind.Enum,
  null: TokenKind.Null,
  while: TokenKind.While,
  match: TokenKind.Match,
  break: TokenKind.Break,
  defer: TokenKind.Defer,
  const: TokenKind.Const,
  struct: TokenKind.Struct,
  import: TokenKind.Import,
  extern: TokenKind.Extern,
  return: TokenKind.Return,
  sizeof: TokenKind.Sizeof,
  alignof: TokenKind.Alignof,
  continue: TokenKind.Continue,
  volatile: TokenKind.Volatile,
}

/** 所有关键字（不含 true/false，它们是布尔字面量）。 */
export const KEYWORD_LIST = [
  'fn',
  'if',
  'in',
  'as',
  'let',
  'mut',
  'for',
  'else',
  'type',
  'enum',
  'null',
  'while',
  'match',
  'break',
  'defer',
  'const',
  'struct',
  'import',
  'extern',
  'return',
  'sizeof',
  'alignof',
  'continue',
  'volatile',
]

export function lookupKeyword(name: string): TokenKind {
  return KEYWORDS[name] ?? TokenKind.Ident
}

/** token 的可读名字 —— 对应编译器 `token_kind_name`，用于 "expected X, got Y"。 */
export function tokenKindName(kind: TokenKind): string {
  switch (kind) {
    case TokenKind.Int:
      return 'int'
    case TokenKind.Float:
      return 'float'
    case TokenKind.String:
      return 'string'
    case TokenKind.Char:
      return 'char'
    case TokenKind.Bool:
      return 'bool'
    case TokenKind.Ident:
      return 'ident'
    case TokenKind.Fn:
      return 'fn'
    case TokenKind.Let:
      return 'let'
    case TokenKind.Mut:
      return 'mut'
    case TokenKind.If:
      return 'if'
    case TokenKind.Else:
      return 'else'
    case TokenKind.While:
      return 'while'
    case TokenKind.For:
      return 'for'
    case TokenKind.In:
      return 'in'
    case TokenKind.Match:
      return 'match'
    case TokenKind.Return:
      return 'return'
    case TokenKind.Break:
      return 'break'
    case TokenKind.Continue:
      return 'continue'
    case TokenKind.Type:
      return 'type'
    case TokenKind.Struct:
      return 'struct'
    case TokenKind.Enum:
      return 'enum'
    case TokenKind.Import:
      return 'import'
    case TokenKind.Extern:
      return 'extern'
    case TokenKind.As:
      return 'as'
    case TokenKind.Sizeof:
      return 'sizeof'
    case TokenKind.Alignof:
      return 'alignof'
    case TokenKind.Const:
      return 'const'
    case TokenKind.Plus:
      return '+'
    case TokenKind.Minus:
      return '-'
    case TokenKind.Star:
      return '*'
    case TokenKind.Slash:
      return '/'
    case TokenKind.Percent:
      return '%'
    case TokenKind.Eq:
      return '='
    case TokenKind.EqEq:
      return '=='
    case TokenKind.BangEq:
      return '!='
    case TokenKind.Lt:
      return '<'
    case TokenKind.Gt:
      return '>'
    case TokenKind.LtEq:
      return '<='
    case TokenKind.GtEq:
      return '>='
    case TokenKind.Bang:
      return '!'
    case TokenKind.Amp:
      return '&'
    case TokenKind.AmpAmp:
      return '&&'
    case TokenKind.Pipe:
      return '|'
    case TokenKind.PipePipe:
      return '||'
    case TokenKind.Tilde:
      return '~'
    case TokenKind.Caret:
      return '^'
    case TokenKind.LtLt:
      return '<<'
    case TokenKind.GtGt:
      return '>>'
    case TokenKind.PlusEq:
      return '+='
    case TokenKind.MinusEq:
      return '-='
    case TokenKind.StarEq:
      return '*='
    case TokenKind.SlashEq:
      return '/='
    case TokenKind.PercentEq:
      return '%='
    case TokenKind.LParen:
      return '('
    case TokenKind.RParen:
      return ')'
    case TokenKind.LBrace:
      return '{'
    case TokenKind.RBrace:
      return '}'
    case TokenKind.LBracket:
      return '['
    case TokenKind.RBracket:
      return ']'
    case TokenKind.Dot:
      return '.'
    case TokenKind.DotDot:
      return '..'
    case TokenKind.Comma:
      return ','
    case TokenKind.Semicolon:
      return ';'
    case TokenKind.Colon:
      return ':'
    case TokenKind.ColonColon:
      return '::'
    case TokenKind.Arrow:
      return '->'
    case TokenKind.FatArrow:
      return '=>'
    case TokenKind.Eof:
      return 'eof'
    case TokenKind.Error:
      return 'error'
    case TokenKind.Null:
      return 'null'
    case TokenKind.Defer:
      return 'defer'
    case TokenKind.Hash:
      return '#'
    case TokenKind.Volatile:
      return 'volatile'
  }
}
