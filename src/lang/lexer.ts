import { lookupKeyword, TokenKind, type Token } from './token'

/**
 * JHYY 词法分析器 —— 移植自 `compiler/src0/lexer.jhyy`。
 *
 * 与编译器版的差异（都是有意的）：
 * - 偏移量用 **UTF-16 code unit 下标**（= JS 字符串下标），不是字节偏移。
 *   这样 IDE 里的位置可以和 CodeMirror 6 直接对上。编译器的字节偏移只存在于
 *   编译器内部，IDE 用不到。
 * - 字符字面量直接按 Unicode 码点处理（编译器那边要手工数 UTF-8 续接字节，
 *   因为它的源码缓冲区是字节数组）。语义等价。
 * - 词法错误以 `kind: Error` 的 token 返回，同时把信息放进 `errorMessage`。
 */
export class Lexer {
  private readonly source: string
  private pos = 0
  private line = 1
  private col = 1

  /** 已缓冲的 lookahead token */
  private peeked: Token | null = null

  constructor(source: string) {
    this.source = source
  }

  // ── 字符级原语 ────────────────────────────────────────────────

  private peekChar(offset = 0): string {
    const i = this.pos + offset
    return i < this.source.length ? this.source[i] : '\0'
  }

  private nextChar(): string {
    if (this.pos >= this.source.length) return '\0'
    const c = this.source[this.pos]
    this.pos++
    if (c === '\n') {
      this.line++
      this.col = 1
    } else {
      this.col++
    }
    return c
  }

  /** 匹配 expected 字符；匹配则前进并返回 true。 */
  private matchChar(expected: string): boolean {
    if (this.peekChar() === expected) {
      this.nextChar()
      return true
    }
    return false
  }

  // ── token 构造 ────────────────────────────────────────────────

  private makeToken(kind: TokenKind, start: number, startLine: number, startCol: number): Token {
    return {
      kind,
      start,
      length: this.pos - start,
      line: startLine,
      col: startCol,
      text: this.source.slice(start, this.pos),
    }
  }

  private errorToken(message: string, start: number, startLine: number, startCol: number): Token {
    return {
      kind: TokenKind.Error,
      start,
      length: this.pos - start,
      line: startLine,
      col: startCol,
      text: this.source.slice(start, this.pos),
      errorMessage: message,
    }
  }

  // ── 空白与注释 ────────────────────────────────────────────────

  private skipLineComment(): void {
    for (;;) {
      const c = this.peekChar()
      if (c === '\0' || c === '\n') return
      this.nextChar()
    }
  }

  private skipBlockComment(): void {
    let depth = 1
    while (depth > 0) {
      const c = this.nextChar()
      if (c === '\0') return // 未闭合
      if (c === '/' && this.peekChar() === '*') {
        this.nextChar()
        depth++
      } else if (c === '*' && this.peekChar() === '/') {
        this.nextChar()
        depth--
      }
    }
  }

  private skipWhitespaceAndComments(): void {
    for (;;) {
      const c = this.peekChar()
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        this.nextChar()
        continue
      }
      if (c === '/') {
        const n1 = this.peekChar(1)
        if (n1 === '/') {
          this.nextChar()
          this.nextChar()
          this.skipLineComment()
          continue
        }
        if (n1 === '*') {
          this.nextChar()
          this.nextChar()
          this.skipBlockComment()
          continue
        }
      }
      return
    }
  }

  // ── 数字 ──────────────────────────────────────────────────────

  private static isDigit(c: string): boolean {
    return c >= '0' && c <= '9'
  }

  private static isHexDigit(c: string): boolean {
    if (c >= '0' && c <= '9') return true
    if (c >= 'a' && c <= 'f') return true
    if (c >= 'A' && c <= 'F') return true
    return false
  }

  private static isAlpha(c: string): boolean {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
  }

  private static isAlnum(c: string): boolean {
    return Lexer.isAlpha(c) || Lexer.isDigit(c)
  }

  /** 扫描数字。第一个数字已经被消费掉了。 */
  private scanNumber(start: number, startLine: number, startCol: number): Token {
    let digitKind: 'dec' | 'hex' | 'oct' | 'bin' = 'dec'

    // 首字符是 '0' 时看前缀
    if (this.source[start] === '0') {
      const p = this.peekChar()
      if (p === 'x' || p === 'X') {
        digitKind = 'hex'
        this.nextChar()
      } else if (p === 'o' || p === 'O') {
        digitKind = 'oct'
        this.nextChar()
      } else if (p === 'b' || p === 'B') {
        digitKind = 'bin'
        this.nextChar()
      }
    }

    const isDigitFor = (c: string): boolean => {
      switch (digitKind) {
        case 'dec':
          return Lexer.isDigit(c)
        case 'hex':
          return Lexer.isHexDigit(c)
        case 'oct':
          return c >= '0' && c <= '7'
        case 'bin':
          return c === '0' || c === '1'
      }
    }

    for (;;) {
      const c = this.peekChar()
      if (!isDigitFor(c)) break
      this.nextChar()
    }

    // 小数部分：只有十进制、且 '.' 后面紧跟数字才是浮点
    // （语言没有指数形式 —— `1.0e10` 会被切成 `1.0` + 标识符 `e10`）
    let isFloat = false
    if (digitKind === 'dec' && this.peekChar() === '.') {
      if (Lexer.isDigit(this.peekChar(1))) {
        isFloat = true
        this.nextChar() // '.'
        while (Lexer.isDigit(this.peekChar())) this.nextChar()
      }
    }

    if (isFloat) {
      // 浮点后缀 f32 / f64 / f —— 后缀属于 token 文本的一部分
      if (this.peekChar() === 'f') {
        this.nextChar()
        while (Lexer.isDigit(this.peekChar())) this.nextChar()
      }
      return this.makeToken(TokenKind.Float, start, startLine, startCol)
    }

    // 整型后缀 i8..i64 / u8..u64
    const p2 = this.peekChar()
    if (p2 === 'i' || p2 === 'u') {
      this.nextChar()
      while (Lexer.isDigit(this.peekChar())) this.nextChar()
    }

    return this.makeToken(TokenKind.Int, start, startLine, startCol)
  }

  // ── 字符串与字符 ──────────────────────────────────────────────

  private scanString(start: number, startLine: number, startCol: number): Token {
    for (;;) {
      const c = this.nextChar()
      if (c === '\0') {
        return this.errorToken('unterminated string literal', start, startLine, startCol)
      }
      if (c === '"') break
      if (c === '\\') {
        const e = this.peekChar()
        if (e === 'n' || e === 't' || e === 'r' || e === '\\' || e === '"' || e === '0') {
          this.nextChar()
        } else if (e === 'x') {
          this.nextChar()
          if (Lexer.isHexDigit(this.peekChar())) this.nextChar()
          if (Lexer.isHexDigit(this.peekChar())) this.nextChar()
        }
        // 未知转义：反斜杠被丢掉，继续扫
      }
    }
    return this.makeToken(TokenKind.String, start, startLine, startCol)
  }

  private scanChar(start: number, startLine: number, startCol: number): Token {
    const c = this.nextChar()
    if (c === '\\') {
      const e = this.peekChar()
      if (e === 'n' || e === 't' || e === 'r' || e === '\\' || e === "'" || e === '"' || e === '0') {
        this.nextChar()
      } else if (e === 'x') {
        this.nextChar()
        if (Lexer.isHexDigit(this.peekChar())) this.nextChar()
        if (Lexer.isHexDigit(this.peekChar())) this.nextChar()
      }
      // 未知转义 → 落到下面的 "unterminated character literal"
    } else if (c >= '\uD800' && c <= '\uDBFF') {
      // 代理对：一个码点占两个 UTF-16 code unit（emoji / 辅助平面）
      const low = this.peekChar()
      if (low >= '\uDC00' && low <= '\uDFFF') this.nextChar()
    }
    const closing = this.nextChar()
    if (closing !== "'") {
      return this.errorToken('unterminated character literal', start, startLine, startCol)
    }
    return this.makeToken(TokenKind.Char, start, startLine, startCol)
  }

  // ── 标识符 / 关键字 ───────────────────────────────────────────

  private scanIdentOrKeyword(start: number, startLine: number, startCol: number): Token {
    for (;;) {
      const c = this.peekChar()
      if (c === '\0') break
      if (!Lexer.isAlnum(c) && c !== '_') break
      this.nextChar()
    }
    const text = this.source.slice(start, this.pos)
    return this.makeToken(lookupKeyword(text), start, startLine, startCol)
  }

  // ── Public API ────────────────────────────────────────────────

  /** 取下一个 token（消耗）。 */
  next(): Token {
    if (this.peeked) {
      const t = this.peeked
      this.peeked = null
      return t
    }
    return this.scan()
  }

  /** 看下一个 token（不消耗）。 */
  peek(): Token {
    if (!this.peeked) this.peeked = this.scan()
    return this.peeked
  }

  private scan(): Token {
    this.skipWhitespaceAndComments()

    const start = this.pos
    const startLine = this.line
    const startCol = this.col
    const c = this.nextChar()

    if (c === '\0') {
      return this.makeToken(TokenKind.Eof, start, startLine, startCol)
    }

    // 括号与标点（单字符的直接返回）
    switch (c) {
      case '(':
        return this.makeToken(TokenKind.LParen, start, startLine, startCol)
      case ')':
        return this.makeToken(TokenKind.RParen, start, startLine, startCol)
      case '{':
        return this.makeToken(TokenKind.LBrace, start, startLine, startCol)
      case '}':
        return this.makeToken(TokenKind.RBrace, start, startLine, startCol)
      case '[':
        return this.makeToken(TokenKind.LBracket, start, startLine, startCol)
      case ']':
        return this.makeToken(TokenKind.RBracket, start, startLine, startCol)
      case ',':
        return this.makeToken(TokenKind.Comma, start, startLine, startCol)
      case ';':
        return this.makeToken(TokenKind.Semicolon, start, startLine, startCol)
      case '#':
        return this.makeToken(TokenKind.Hash, start, startLine, startCol)
      case '~':
        return this.makeToken(TokenKind.Tilde, start, startLine, startCol)
      case '^':
        return this.makeToken(TokenKind.Caret, start, startLine, startCol)
    }

    // 双字符运算符
    switch (c) {
      case ':':
        return this.matchChar(':')
          ? this.makeToken(TokenKind.ColonColon, start, startLine, startCol)
          : this.makeToken(TokenKind.Colon, start, startLine, startCol)
      case '.':
        return this.matchChar('.')
          ? this.makeToken(TokenKind.DotDot, start, startLine, startCol)
          : this.makeToken(TokenKind.Dot, start, startLine, startCol)
      case '+':
        return this.matchChar('=')
          ? this.makeToken(TokenKind.PlusEq, start, startLine, startCol)
          : this.makeToken(TokenKind.Plus, start, startLine, startCol)
      case '-':
        if (this.matchChar('=')) return this.makeToken(TokenKind.MinusEq, start, startLine, startCol)
        if (this.matchChar('>')) return this.makeToken(TokenKind.Arrow, start, startLine, startCol)
        return this.makeToken(TokenKind.Minus, start, startLine, startCol)
      case '*':
        return this.matchChar('=')
          ? this.makeToken(TokenKind.StarEq, start, startLine, startCol)
          : this.makeToken(TokenKind.Star, start, startLine, startCol)
      case '/':
        return this.matchChar('=')
          ? this.makeToken(TokenKind.SlashEq, start, startLine, startCol)
          : this.makeToken(TokenKind.Slash, start, startLine, startCol)
      case '%':
        return this.matchChar('=')
          ? this.makeToken(TokenKind.PercentEq, start, startLine, startCol)
          : this.makeToken(TokenKind.Percent, start, startLine, startCol)
      case '=':
        if (this.matchChar('=')) return this.makeToken(TokenKind.EqEq, start, startLine, startCol)
        if (this.matchChar('>')) return this.makeToken(TokenKind.FatArrow, start, startLine, startCol)
        return this.makeToken(TokenKind.Eq, start, startLine, startCol)
      case '!':
        return this.matchChar('=')
          ? this.makeToken(TokenKind.BangEq, start, startLine, startCol)
          : this.makeToken(TokenKind.Bang, start, startLine, startCol)
      case '<':
        if (this.matchChar('=')) return this.makeToken(TokenKind.LtEq, start, startLine, startCol)
        if (this.matchChar('<')) return this.makeToken(TokenKind.LtLt, start, startLine, startCol)
        return this.makeToken(TokenKind.Lt, start, startLine, startCol)
      case '>':
        if (this.matchChar('=')) return this.makeToken(TokenKind.GtEq, start, startLine, startCol)
        if (this.matchChar('>')) return this.makeToken(TokenKind.GtGt, start, startLine, startCol)
        return this.makeToken(TokenKind.Gt, start, startLine, startCol)
      case '&':
        return this.matchChar('&')
          ? this.makeToken(TokenKind.AmpAmp, start, startLine, startCol)
          : this.makeToken(TokenKind.Amp, start, startLine, startCol)
      case '|':
        return this.matchChar('|')
          ? this.makeToken(TokenKind.PipePipe, start, startLine, startCol)
          : this.makeToken(TokenKind.Pipe, start, startLine, startCol)
    }

    if (Lexer.isDigit(c)) return this.scanNumber(start, startLine, startCol)
    if (c === '"') return this.scanString(start, startLine, startCol)
    if (c === "'") return this.scanChar(start, startLine, startCol)
    if (Lexer.isAlpha(c) || c === '_') return this.scanIdentOrKeyword(start, startLine, startCol)

    return this.errorToken('unexpected character', start, startLine, startCol)
  }
}

/** 把整个源文件切成 token 数组（出错时用 Error token 表示）。 */
export function tokenize(source: string): Token[] {
  const lexer = new Lexer(source)
  const tokens: Token[] = []
  for (;;) {
    const t = lexer.next()
    tokens.push(t)
    if (t.kind === TokenKind.Eof) break
  }
  return tokens
}
